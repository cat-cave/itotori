use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use kaifuu_core::{
    AdapterFailure, AdapterRegistry, EngineAdapter, KaifuuResult, PatchExport,
    PatchPreflightRequest, PatchRequest, PatchResult, promote_staged_directory_no_clobber,
    read_json, redact_diagnostic_for_operator, redact_report_value, write_json,
};
use kaifuu_delta::apply_delta;

use crate::{flag, flag_optional, positional, registered_adapter_for_game};

const APPLY_REPORT_FILE_NAME: &str = "patch-result.json";

fn operator_path_for_diagnostic(path: &Path) -> String {
    redact_diagnostic_for_operator(&path.display().to_string())
}

pub(super) fn run_patch_command(
    args: &[String],
    registry: &AdapterRegistry,
) -> Result<(), Box<dyn std::error::Error>> {
    let game_dir = PathBuf::from(positional(args, 1)?);
    let patch = PathBuf::from(flag(args, "--patch")?);
    let output = PathBuf::from(flag(args, "--output")?);
    validate_patch_target_root(&game_dir, &output, "patch output directory")?;
    let patch_export: PatchExport = read_json(&patch)?;
    let adapter = registered_adapter_for_game(registry, &game_dir)?;
    let preflight = adapter
        .patch_preflight(PatchPreflightRequest {
            game_dir: &game_dir,
            patch_export: &patch_export,
        })?
        .redacted_for_report();
    if preflight.status == kaifuu_core::OperationStatus::Failed
        && preflight.has_preflight_blocking_failure()
    {
        return Err(patch_preflight_failure_message(&preflight).into());
    }
    let result = run_patch_with_owned_staging(adapter, &game_dir, &patch_export, &output)?;
    if result.status == kaifuu_core::OperationStatus::Failed {
        return Err(format!(
            "patch failed; see {}",
            operator_path_for_diagnostic(&output.join(APPLY_REPORT_FILE_NAME))
        )
        .into());
    }
    Ok(())
}

pub(super) fn run_apply_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let game_dir = PathBuf::from(positional(args, 1)?);
    let patch = PathBuf::from(flag(args, "--patch")?);
    let output = PathBuf::from(flag(args, "--output")?);
    let report_output = flag_optional(args, "--report-output")
        .map(PathBuf::from)
        .map_or_else(|| default_apply_report_output(&output), Ok)?;
    let report_output = validate_apply_report_output(&game_dir, &output, &report_output)?;
    let result = apply_delta(&game_dir, &patch, &output)?;
    write_apply_report_json(&report_output, &redact_report_value(&result))?;
    Ok(())
}

fn run_patch_with_owned_staging(
    adapter: &dyn EngineAdapter,
    game_dir: &Path,
    patch_export: &PatchExport,
    output: &Path,
) -> KaifuuResult<PatchResult> {
    let staging_output = allocate_patch_staging_dir(output)?;
    let result = match adapter.patch(PatchRequest {
        game_dir,
        patch_export,
        output_dir: &staging_output,
    }) {
        Ok(result) => result.redacted_for_report(),
        Err(error) => {
            remove_patch_staging_dir(&staging_output)?;
            return Err(error);
        }
    };
    if result.status == kaifuu_core::OperationStatus::Failed
        && result.has_preflight_blocking_failure()
    {
        remove_patch_staging_dir(&staging_output)?;
        return Err(patch_preflight_failure_message(&result).into());
    }
    if let Err(error) = write_json(&staging_output.join(APPLY_REPORT_FILE_NAME), &result) {
        remove_patch_staging_dir(&staging_output)?;
        return Err(error);
    }
    if let Err(error) = promote_patch_staging_dir(&staging_output, output) {
        remove_patch_staging_dir(&staging_output)?;
        return Err(error);
    }
    Ok(result)
}

fn patch_preflight_failure_message(result: &PatchResult) -> String {
    let details = result
        .failures
        .iter()
        .map(patch_preflight_failure_detail)
        .collect::<Vec<_>>();
    if details.is_empty() {
        "patch preflight failed".to_string()
    } else {
        format!("patch preflight failed: {}", details.join("; "))
    }
}

fn patch_preflight_failure_detail(failure: &AdapterFailure) -> String {
    let mut detail = redact_diagnostic_for_operator(&failure.error_code);
    if !failure.support_boundary.is_empty() {
        detail.push_str(" (");
        detail.push_str(&redact_diagnostic_for_operator(&failure.support_boundary));
        if let Some(remediation) = &failure.remediation {
            detail.push_str("; remediation ");
            detail.push_str(&redact_diagnostic_for_operator(remediation));
        }
        detail.push(')');
    } else if let Some(remediation) = &failure.remediation {
        detail.push_str(" (remediation ");
        detail.push_str(&redact_diagnostic_for_operator(remediation));
        detail.push(')');
    }
    detail
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

pub(super) fn validate_patch_target_root(
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
                operator_path_for_diagnostic(target_root)
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
            operator_path_for_diagnostic(source_root)
        )
    })?;
    let target_root_canonical = canonical_existing_prefix(target_root)?;

    if source_root_lexical == target_root_lexical || source_root_canonical == target_root_canonical
    {
        return Err(format!(
            "{target_label} must not alias source game directory: {}",
            operator_path_for_diagnostic(target_root)
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
            operator_path_for_diagnostic(target_root)
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
            operator_path_for_diagnostic(report_output)
        )
        .into());
    }
    if path_is_inside_root(&report_path, &output_root)
        || path_is_inside_root(&report_path_canonical, &output_root_canonical)
    {
        return Err(format!(
            "apply report output must not be inside patched output directory: {}",
            operator_path_for_diagnostic(report_output)
        )
        .into());
    }
    reject_existing_symlink_components(&report_path)?;
    Ok(report_path)
}

pub(super) fn path_is_inside_root(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

pub(super) fn canonical_existing_prefix(path: &Path) -> KaifuuResult<PathBuf> {
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
                        operator_path_for_diagnostic(&current)
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
                                operator_path_for_diagnostic(&current)
                            )
                            .into());
                        }
                        if !metadata.is_dir() {
                            return Err(format!(
                                "apply report output parent must be a directory: {}",
                                operator_path_for_diagnostic(&current)
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
                                operator_path_for_diagnostic(&current)
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

pub(super) fn lexical_absolute_path(path: &Path) -> KaifuuResult<PathBuf> {
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

pub(super) fn allocate_patch_staging_dir(output: &Path) -> KaifuuResult<PathBuf> {
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

pub(super) fn remove_patch_staging_dir(staging_output: &Path) -> KaifuuResult<()> {
    match fs::remove_dir_all(staging_output) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn promote_patch_staging_dir(staging_output: &Path, output: &Path) -> KaifuuResult<()> {
    promote_staged_directory_no_clobber(staging_output, output, "patch output directory")
}
