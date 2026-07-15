use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use kaifuu_core::{KaifuuResult, atomic_write_bytes, sha256_hash_bytes};
use kaifuu_delta::{Replacement, SourceProvenance, create_replacement_delta};

use super::paths::{
    local_path_for_diagnostic, reallive_patch_read_source_error,
    reallive_patch_source_mutated_error, reallive_patch_write_target_error,
    reject_reallive_target_tree_symlinks, resolve_reallive_seen_path,
};
use crate::{
    canonical_existing_prefix, flag, flag_optional, lexical_absolute_path, path_is_inside_root,
    validate_patch_target_root,
};

/// `patch --engine reallive --source <readonly> --target <writable>
/// --bundle bridge-bundle-translated.json --scope <dialogue-only|dialogue+choices>
/// [--delta-output <delta.kaifuu>] [--force]`.
/// `--scope` is the user's translation-scope config and is REQUIRED: it
/// drives the config-driven byte-fidelity contract. `dialogue-only`
/// translates only dialogue Textout bodies and carries every choice /
/// non-dialogue surface byte-identical; `dialogue+choices` additionally
/// re-emits `module_sel` choice options NextString-safe.
/// Reads the translated v0.2 BridgeBundle, patches the source's
/// `REALLIVEDATA/Seen.txt` via [`kaifuu_reallive::apply_translated_bundle`],
/// and writes the patched archive to the SAME relative path under the
/// writable target (per the readonly-source / writable-target discipline
/// called out in the audit-focus row). Only the target archive
/// is touched: the multi-GB voice/image siblings of a real game tree are
/// never read, copied, or written
/// (`kaifuu-patch-touch-archive-not-copy-game-tree`) — a per-scene patch
/// stays target-archive-sized, not full-tree-sized. The source tree is
/// sha256-unchanged after the command. When requested, `--delta-output`
/// produces a replacement-only v0.3 package from the in-memory patched
/// archive: its target manifest inherits every source sibling, but it embeds
/// only the resolved Seen.txt replacement bytes.
pub(crate) fn run_patch_reallive_bundle(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    use kaifuu_reallive::{
        PATCHBACK_TARGET_NONEMPTY_CODE, PatchbackOpts, TranslatedBundleV02, TranslationScope,
        apply_translated_bundle,
    };

    let source_root = PathBuf::from(flag(args, "--source")?);
    let target_root = PathBuf::from(flag(args, "--target")?);
    let bundle_path = PathBuf::from(flag(args, "--bundle")?);
    let delta_output = flag_optional(args, "--delta-output").map(PathBuf::from);
    let force = flag_optional(args, "--force").is_some();

    // Validate the untrusted target path BEFORE anything else (symlink
    // rejection must not depend on other flags being well-formed).
    validate_patch_target_root(&source_root, &target_root, "patch target directory")?;
    reject_reallive_target_tree_symlinks(&target_root)?;
    if let Some(delta_output) = delta_output.as_deref() {
        validate_reallive_delta_output(&source_root, &target_root, delta_output)?;
    }

    // The caller declares the translation scope; it drives the config-driven
    // byte-fidelity contract (out-of-scope surfaces carried byte-identical,
    // in-scope surfaces round-tripped byte-correct). No silent default —
    // `--scope` is required and its token must be recognised.
    let scope_token = flag(args, "--scope")?;
    let scope = TranslationScope::parse_token(scope_token).ok_or_else(
        || -> Box<dyn std::error::Error> {
            format!(
                "--scope must be one of `dialogue-only` | `dialogue+choices`; got {scope_token:?}"
            )
            .into()
        },
    )?;

    // Refuse to overwrite a non-empty target without --force. The error
    // code is the documented patchback_target_nonempty Fatal
    if target_root.exists() && !force {
        let nonempty = fs::read_dir(&target_root).is_ok_and(|mut entries| entries.next().is_some());
        if nonempty {
            return Err(format!(
                "{PATCHBACK_TARGET_NONEMPTY_CODE}: target {} is non-empty; rerun with --force to overwrite",
                target_root.display()
            )
            .into());
        }
    }

    let bundle_bytes = fs::read(&bundle_path).map_err(|err| -> Box<dyn std::error::Error> {
        format!(
            "failed to read translated bundle {}: {err}",
            bundle_path.display()
        )
        .into()
    })?;
    let bundle_value: serde_json::Value =
        serde_json::from_slice(&bundle_bytes).map_err(|err| -> Box<dyn std::error::Error> {
            format!("translated bundle JSON parse: {err}").into()
        })?;
    let translated = TranslatedBundleV02::from_json(&bundle_value)
        .map_err(|err| -> Box<dyn std::error::Error> { format!("{err}").into() })?;

    let source_seen_path = resolve_reallive_seen_path(&source_root)?;
    let source_seen_bytes =
        fs::read(&source_seen_path).map_err(|err| -> Box<dyn std::error::Error> {
            reallive_patch_read_source_error(&source_seen_path, &err).into()
        })?;
    let source_seen_hash = sha256_hash_bytes(&source_seen_bytes);

    // Pilot throughput (kaifuu-patch-touch-archive-not-copy-game-tree):
    // TOUCH ONLY THE TARGET ARCHIVE. A RealLive game tree is dominated by
    // multi-GB voice + image siblings (~5.7GB) surrounding a ~3.7MB
    // Seen.txt; copying the whole tree to patch one archive is infeasible
    // per scene. We materialise the patched Seen.txt at the SAME relative
    // path under the target as it holds under the source, creating ONLY its
    // enclosing `REALLIVEDATA/` directory. The voice/image siblings are
    // never read, copied, or touched — the patch footprint is exactly the
    // target archive.
    let source_seen_rel = source_seen_path.strip_prefix(&source_root).map_err(
        |_| -> Box<dyn std::error::Error> {
            format!(
                "kaifuu.reallive.patchback_seen_path_outside_source_root: resolved Seen.txt {} is not under source root {}",
                local_path_for_diagnostic(&source_seen_path),
                local_path_for_diagnostic(&source_root),
            )
            .into()
        },
    )?;
    let patched = apply_translated_bundle(
        &source_seen_bytes,
        &translated,
        &PatchbackOpts::shift_jis(scope),
    )
    .map_err(|err| -> Box<dyn std::error::Error> { format!("{err}").into() })?;

    // Build and persist the optional package before creating anything under
    // the sparse target tree. A bad delta destination or rejected source
    // snapshot therefore cannot leave a patched target behind. The package
    // uses the exact resolved Seen-relative path already used by the target
    // overlay, and carries only the complete source provenance this CLI route
    // can establish without inventing a new provenance-input flag.
    if let Some(delta_output) = delta_output {
        let seen_relative_path = reallive_delta_relative_path(source_seen_rel)?;
        let delta = create_replacement_delta(
            &source_root,
            &[Replacement {
                path: seen_relative_path,
                bytes: patched.clone(),
            }],
            SourceProvenance::complete(),
        )?;
        let delta_bytes = kaifuu_core::stable_json(&delta)?;
        atomic_write_bytes(&delta_output, delta_bytes.as_bytes())?;
    }

    let target_seen_path = target_root.join(source_seen_rel);
    atomic_write_bytes(&target_seen_path, &patched).map_err(
        |err| -> Box<dyn std::error::Error> {
            reallive_patch_write_target_error(&target_seen_path, err.as_ref()).into()
        },
    )?;

    // Readonly-source sha256 invariant: re-read the source and assert
    // it still matches the pre-write hash. This is the
    // "Readonly source mutated by the copy step" audit-focus mitigation.
    let post_source_bytes = fs::read(&source_seen_path)?;
    let post_source_hash = sha256_hash_bytes(&post_source_bytes);
    if post_source_hash != source_seen_hash {
        return Err(reallive_patch_source_mutated_error(
            &source_seen_path,
            &source_seen_hash,
            &post_source_hash,
        )
        .into());
    }
    Ok(())
}

/// Convert an already-resolved Seen.txt-relative path into the POSIX UTF-8
/// path form required by the delta package. Components are retained exactly
/// (including case); only the platform separator is normalized at this
/// serialization boundary.
fn reallive_delta_relative_path(relative: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(
                part.to_str()
                    .ok_or(
                        "kaifuu.reallive.delta_path_not_utf8: Seen.txt relative path must be UTF-8",
                    )?
                    .to_string(),
            ),
            _ => {
                return Err(
                    "kaifuu.reallive.delta_path_unsafe: resolved Seen.txt path must be a normal relative path"
                        .into(),
                );
            }
        }
    }
    if parts.is_empty() {
        return Err("kaifuu.reallive.delta_path_empty: resolved Seen.txt path is empty".into());
    }
    Ok(parts.join("/"))
}

/// A delta is an external package, never an in-place source mutation or a
/// member of the sparse overlay it describes. Check both lexical and existing
/// canonical prefixes before any package or target write.
fn validate_reallive_delta_output(
    source_root: &Path,
    target_root: &Path,
    delta_output: &Path,
) -> KaifuuResult<()> {
    let source_lexical = lexical_absolute_path(source_root)?;
    let target_lexical = lexical_absolute_path(target_root)?;
    let delta_lexical = lexical_absolute_path(delta_output)?;
    let source_canonical = canonical_existing_prefix(source_root)?;
    let target_canonical = canonical_existing_prefix(target_root)?;
    let delta_canonical = canonical_existing_prefix(delta_output)?;

    if path_is_inside_root(&delta_lexical, &source_lexical)
        || path_is_inside_root(&delta_canonical, &source_canonical)
    {
        return Err(format!(
            "kaifuu.reallive.delta_output_inside_source: delta output must not be inside source game directory: {}",
            local_path_for_diagnostic(delta_output)
        )
        .into());
    }
    if path_is_inside_root(&delta_lexical, &target_lexical)
        || path_is_inside_root(&delta_canonical, &target_canonical)
    {
        return Err(format!(
            "kaifuu.reallive.delta_output_inside_target: delta output must not be inside sparse patch target: {}",
            local_path_for_diagnostic(delta_output)
        )
        .into());
    }
    reject_reallive_delta_output_symlink_components(&delta_lexical)?;
    Ok(())
}

fn reject_reallive_delta_output_symlink_components(path: &Path) -> KaifuuResult<()> {
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
                        "kaifuu.reallive.delta_output_symlink: delta output path must not contain symlinks: {}",
                        local_path_for_diagnostic(&current)
                    )
                    .into());
                }
            }
        }
    }
    Ok(())
}
