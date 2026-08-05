use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use kaifuu_core::redact_diagnostic_for_operator;

pub(crate) fn local_path_for_diagnostic(path: &Path) -> String {
    redact_diagnostic_for_operator(&path.display().to_string())
}

pub(crate) fn reallive_patch_read_source_error(path: &Path, error: &io::Error) -> String {
    format!(
        "failed to read source Seen.txt {}: {error}",
        local_path_for_diagnostic(path)
    )
}

pub(crate) fn reallive_patch_write_target_error(
    path: &Path,
    error: &dyn std::error::Error,
) -> String {
    format!(
        "failed to write patched Seen.txt {}: {error}",
        local_path_for_diagnostic(path)
    )
}

pub(crate) fn reallive_patch_source_mutated_error(
    path: &Path,
    before: &str,
    after: &str,
) -> String {
    format!(
        "kaifuu.reallive.patchback_source_mutated: source Seen.txt at {} changed from {before} to {after} during the patch step",
        local_path_for_diagnostic(path),
    )
}

pub(crate) fn reject_reallive_target_tree_symlinks(
    target_root: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let root_metadata = match fs::symlink_metadata(target_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if root_metadata.file_type().is_symlink() {
        return Err(format!(
            "kaifuu.reallive.patchback_target_symlink: target tree must not contain symlinks before patching: {}",
            local_path_for_diagnostic(target_root)
        )
        .into());
    }
    if !root_metadata.is_dir() {
        return Ok(());
    }

    let mut stack = vec![target_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "kaifuu.reallive.patchback_target_symlink: target tree must not contain symlinks before patching: {}",
                    local_path_for_diagnostic(&path)
                )
                .into());
            }
            if metadata.is_dir() {
                stack.push(path);
            }
        }
    }
    Ok(())
}

/// Resolve SEEN archive + Gameexe paths for either known RealLive layout.
/// Layout discovery is a format property (`kaifuu_reallive::resolve_layout`);
/// the CLI does not take a layout flag.
pub(crate) fn resolve_reallive_layout(
    game_root: &Path,
) -> Result<kaifuu_reallive::RealLiveResolvedLayout, Box<dyn std::error::Error>> {
    kaifuu_reallive::resolve_layout(game_root)
        .map_err(|err| -> Box<dyn std::error::Error> { err.to_string().into() })
}

pub(crate) fn resolve_reallive_seen_path(
    game_root: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(resolve_reallive_layout(game_root)?.seen_txt)
}

/// Alpha by-id sourcing: resolve a RealLive corpus through the read-only vault
/// adapter and return the materialised game-tree root (the `<canonical_id>/`
/// wrapper under scratch). The catalog is opened `mode=ro` and every byte
/// lands under scratch — the vault is never written. The extracted tree is
/// intentionally left in place (the caller process produces its bundle and
/// exits); retention/cleanup is the operator's concern.
pub(crate) fn resolve_reallive_game_root_via_vault(
    canonical_id: &str,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    use kaifuu_vault_source::{
        ClaimQuery, LocalCorpusSource, MaterializeOptions, ScratchConfig, VaultConfig, VaultSource,
    };

    let source = VaultSource::open(&VaultConfig::default(), &ScratchConfig::default()).map_err(
        |err| -> Box<dyn std::error::Error> { format!("kaifuu.vault.open: {err}").into() },
    )?;
    let candidate = source
        .discover(&ClaimQuery::ByCanonicalId {
            canonical_id: canonical_id.to_string(),
        })
        .map_err(|err| -> Box<dyn std::error::Error> {
            format!("kaifuu.vault.discover: {err}").into()
        })?
        .into_iter()
        .next()
        .ok_or_else(|| -> Box<dyn std::error::Error> {
            format!("kaifuu.vault.release_not_resolved: no release for canonical_id {canonical_id}")
                .into()
        })?;
    let materialized = source
        .materialize(&candidate, MaterializeOptions::default())
        .map_err(|err| -> Box<dyn std::error::Error> {
            format!("kaifuu.vault.materialize: {err}").into()
        })?;
    Ok(materialized.tree_root)
}

/// Read `Gameexe.ini` bytes for the RealLive bridge, surfacing a structured
/// kaifuu diagnostic instead of silently degrading to an empty inventory.
/// `Gameexe.ini` is mandatory for a RealLive title, so its absence is a real
/// extraction failure rather than a legitimate empty-inventory case. A
/// genuinely-absent file and an unreadable/corrupt one are distinguished so the
/// downstream patch-back never trusts a structurally-valid-but-wrong bundle:
/// - `kaifuu.reallive.gameexe_absent` — `ErrorKind::NotFound`.
/// - `kaifuu.reallive.gameexe_unreadable` — any other I/O error (e.g. a
///   permission-denied `chmod 000` Gameexe.ini, or a mid-read I/O fault).
pub(crate) fn read_gameexe_inventory_bytes(
    gameexe_path: &Path,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    match fs::read(gameexe_path) {
        Ok(bytes) => Ok(bytes),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Err(format!(
            "kaifuu.reallive.gameexe_absent: required Gameexe.ini not found at {}",
            gameexe_path.display()
        )
        .into()),
        Err(err) => Err(format!(
            "kaifuu.reallive.gameexe_unreadable: failed to read {}: {err}",
            gameexe_path.display()
        )
        .into()),
    }
}
