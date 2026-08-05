//! Softpal ADV (Amuse Craft / "Pal") CLI surface: `extract`/`patch`/`verify`
//! under `--engine softpal`, routed through the SAME command structure as the
//! RealLive/RPG Maker flag paths. Every arm drives the real
//! [`kaifuu_engine_fixture::SoftpalProfileDetectorAdapter`] (which wires the
//! deterministic `kaifuu-softpal` PAC + TEXT.DAT + SCRIPT.SRC reader and its
//! patch-back) over real bytes — there is no mock path.
//!
//! - `extract --engine softpal --game-root <root> --scope all --bundle-output <bundle.json>` resolves
//!   SCRIPT.SRC + TEXT.DAT (from `data.pac` or a loose pair), disassembles the
//!   dialogue + choice surfaces, and writes the v0.2 BridgeBundle. It requires
//!   the generic `--game-root` input; positional and `--game-dir` aliases are
//!   not accepted on this public extract surface.
//! - `patch --engine softpal <root> --patch <export.json> --output <dir>`
//!   rebuilds TEXT.DAT + repoints SCRIPT.SRC as loose files in `<dir>` and writes
//!   `patch-result.json` (`--source <root>` is an alternate to the positional).
//! - `verify --engine softpal <root> [--output <report.json>]` re-decodes and
//!   asserts the 0-dangling-pointer integrity bar.

use std::path::PathBuf;

mod selection;

use kaifuu_core::{
    EngineAdapter, ExtractRequest, PatchExport, PatchRequest, VerifyRequest, write_json,
};
use kaifuu_engine_fixture::SoftpalProfileDetectorAdapter;

use crate::{
    extract_scope::parse_extract_scope, flag, flag_optional, flag_present, read_json,
    validate_patch_target_root,
};

/// The first positional argument after the verb (`args[0]`): the first token
/// that is neither a `--flag` nor a flag's value. Lets the game root be passed
/// positionally alongside `--engine softpal` and the output flags.
fn first_positional(args: &[String]) -> Option<&str> {
    let mut index = 1;
    while index < args.len() {
        if args[index].starts_with("--") {
            index += 2; // skip the flag and its value
        } else {
            return Some(&args[index]);
        }
    }
    None
}

/// Resolve the Softpal game root from the engine-neutral `--game-root` first,
/// then the historical aliases used by lower-level commands.
fn softpal_game_dir(args: &[String]) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(value) = flag_optional(args, "--game-root") {
        return Ok(PathBuf::from(value));
    }
    if let Some(value) = flag_optional(args, "--game-dir") {
        return Ok(PathBuf::from(value));
    }
    if let Some(value) = first_positional(args) {
        return Ok(PathBuf::from(value));
    }
    Err("softpal game root required: pass --game-root <root>".into())
}

/// Resolve the generic source root for the public extract command. Unlike
/// lower-level patch and verify routes, extraction deliberately has no
/// historical positional or `--game-dir` compatibility inputs.
fn softpal_extract_game_root(args: &[String]) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if flag_present(args, "--game-dir") {
        return Err(
            "kaifuu.softpal.extract.legacy_flag: --game-dir is not supported; use --game-root <PATH>"
                .into(),
        );
    }
    if first_positional(args).is_some() {
        return Err(
            "kaifuu.softpal.extract.legacy_positional: positional source roots are not supported; use --game-root <PATH>"
                .into(),
        );
    }
    flag_optional(args, "--game-root")
        .map(PathBuf::from)
        .ok_or("kaifuu.softpal.extract.game_root_required: --game-root <PATH> required".into())
}

/// Dispatch `--engine softpal` `extract`/`patch`/`verify` (verb is `args[0]`).
pub(crate) fn run_softpal_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match args.first().map(String::as_str) {
        Some("extract") => run_extract_softpal_bundle(args),
        Some("patch") => run_patch_softpal_bundle(args),
        Some("verify") => run_verify_softpal(args),
        _ => Err("usage: kaifuu <extract|patch|verify> --engine softpal ...".into()),
    }
}

fn run_extract_softpal_bundle(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let scope = parse_extract_scope(args)?;
    let game_dir = softpal_extract_game_root(args)?;
    let bundle_output = PathBuf::from(flag(args, "--bundle-output")?);
    let extraction = SoftpalProfileDetectorAdapter.extract(ExtractRequest {
        game_dir: &game_dir,
    })?;
    let bridge = &extraction.bridge;
    let units = bridge
        .get("units")
        .and_then(|value| value.as_array())
        .ok_or("kaifuu.softpal.extract.invalid_bundle: v0.2 bridge is missing its units array")?;
    let source_unit_keys = units
        .iter()
        .enumerate()
        .map(|(index, unit)| {
            unit.get("sourceUnitKey")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
                .ok_or_else(|| {
                    format!(
                        "kaifuu.softpal.extract.invalid_bundle: unit {index} is missing sourceUnitKey"
                    )
                    .into()
                })
        })
        .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
    let selected = selection::select_unit_indices(&scope, &source_unit_keys)?;
    let selected_units = selected
        .into_iter()
        .map(|index| units[index].clone())
        .collect::<Vec<_>>();
    let mut filtered = bridge.clone();
    filtered["units"] = serde_json::Value::Array(selected_units);
    write_json(&bundle_output, &filtered)?;
    let unit_count = filtered
        .get("units")
        .and_then(|value| value.as_array())
        .map_or(0, Vec::len);
    eprintln!(
        "kaifuu softpal extract: units={unit_count} warnings={}",
        extraction.warnings.len(),
    );
    Ok(())
}

fn run_patch_softpal_bundle(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let source = match flag_optional(args, "--source") {
        Some(value) => PathBuf::from(value),
        None => PathBuf::from(first_positional(args).ok_or(
            "softpal patch source root required: pass it positionally or via --source <root>",
        )?),
    };
    let patch = PathBuf::from(flag(args, "--patch")?);
    let output = PathBuf::from(flag(args, "--output")?);
    validate_patch_target_root(&source, &output, "patch output directory")?;
    let patch_export: PatchExport = read_json(&patch)?;
    std::fs::create_dir_all(&output)?;
    let result = SoftpalProfileDetectorAdapter
        .patch(PatchRequest {
            game_dir: &source,
            patch_export: &patch_export,
            output_dir: &output,
        })?
        .redacted_for_report();
    write_json(&output.join("patch-result.json"), &result)?;
    if result.status == kaifuu_core::OperationStatus::Failed {
        return Err(format!(
            "softpal patch failed; see {}",
            output.join("patch-result.json").display()
        )
        .into());
    }
    eprintln!(
        "kaifuu softpal patch: status=passed output={}",
        output.display()
    );
    Ok(())
}

fn run_verify_softpal(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let game_dir = softpal_game_dir(args)?;
    let output = flag_optional(args, "--output").unwrap_or("verify-result.json");
    let result = SoftpalProfileDetectorAdapter
        .verify(VerifyRequest {
            game_dir: &game_dir,
        })?
        .redacted_for_report();
    write_json(&PathBuf::from(output), &result)?;
    if result.status == kaifuu_core::OperationStatus::Failed {
        return Err(format!("softpal verify reported integrity failures; see {output}").into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn extract_requires_the_generic_game_root_flag() {
        let error =
            softpal_extract_game_root(&args(&["extract", "--engine", "softpal", "--scope", "all"]))
                .expect_err("an extract source root is required");

        assert!(error.to_string().contains("game_root_required"));
        assert!(error.to_string().contains("--game-root <PATH>"));
    }

    #[test]
    fn extract_rejects_the_legacy_game_dir_flag() {
        let error = softpal_extract_game_root(&args(&[
            "extract",
            "--engine",
            "softpal",
            "--game-dir",
            "legacy-root",
            "--scope",
            "all",
        ]))
        .expect_err("the old path flag has no compatibility shim");

        assert!(error.to_string().contains("legacy_flag"));
        assert!(error.to_string().contains("--game-dir is not supported"));
        assert!(error.to_string().contains("--game-root <PATH>"));
    }

    #[test]
    fn extract_rejects_a_legacy_positional_source_root() {
        let error = softpal_extract_game_root(&args(&[
            "extract",
            "--engine",
            "softpal",
            "legacy-root",
            "--scope",
            "all",
        ]))
        .expect_err("a positional source root has no compatibility shim");

        assert!(error.to_string().contains("legacy_positional"));
        assert!(
            error
                .to_string()
                .contains("positional source roots are not supported")
        );
        assert!(error.to_string().contains("--game-root <PATH>"));
    }

    #[test]
    fn extract_accepts_the_generic_game_root_flag() {
        let root = softpal_extract_game_root(&args(&[
            "extract",
            "--engine",
            "softpal",
            "--game-root",
            "generic-root",
            "--scope",
            "all",
        ]))
        .expect("the generic source root is accepted");

        assert_eq!(root, PathBuf::from("generic-root"));
    }
}
