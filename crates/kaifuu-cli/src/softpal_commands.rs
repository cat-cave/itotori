//! Softpal ADV (Amuse Craft / "Pal") CLI surface: `extract`/`patch`/`verify`
//! under `--engine softpal`, routed through the SAME command structure as the
//! RealLive/RPG Maker flag paths. Every arm drives the real
//! [`kaifuu_engine_fixture::SoftpalProfileDetectorAdapter`] (which wires the
//! deterministic `kaifuu-softpal` PAC + TEXT.DAT + SCRIPT.SRC reader and its
//! patch-back) over real bytes — there is no mock path.
//!
//! - `extract --engine softpal --game-dir <root> --bundle-output <bundle.json>`
//!   resolves SCRIPT.SRC + TEXT.DAT (from `data.pac` or a loose pair),
//!   disassembles the dialogue + choice surfaces, and writes the v0.1
//!   BridgeBundle.
//! - `patch --engine softpal --source <root> --patch <export.json>
//!   --output <dir>` rebuilds TEXT.DAT + repoints SCRIPT.SRC as loose files in
//!   `<dir>` and writes `patch-result.json`.
//! - `verify --engine softpal --game-dir <root> [--output <report.json>]`
//!   re-decodes and asserts the 0-dangling-pointer integrity bar.

use std::path::PathBuf;

use kaifuu_core::{
    EngineAdapter, ExtractRequest, PatchExport, PatchRequest, VerifyRequest, write_json,
};
use kaifuu_engine_fixture::SoftpalProfileDetectorAdapter;

use crate::{flag, flag_optional, read_json, validate_patch_target_root};

/// `--game-dir <root>` (falling back to `ITOTORI_REAL_GAME_ROOT_SOFTPAL`).
fn softpal_game_dir(args: &[String]) -> Result<PathBuf, Box<dyn std::error::Error>> {
    match flag_optional(args, "--game-dir") {
        Some(value) => Ok(PathBuf::from(value)),
        None => match std::env::var_os("ITOTORI_REAL_GAME_ROOT_SOFTPAL") {
            Some(value) => Ok(PathBuf::from(value)),
            None => Err(
                "--game-dir <softpal-root> or ITOTORI_REAL_GAME_ROOT_SOFTPAL env var required"
                    .into(),
            ),
        },
    }
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
    let game_dir = softpal_game_dir(args)?;
    let bundle_output = PathBuf::from(flag(args, "--bundle-output")?);
    let extraction = SoftpalProfileDetectorAdapter.extract(ExtractRequest {
        game_dir: &game_dir,
    })?;
    write_json(&bundle_output, &extraction.bridge)?;
    eprintln!(
        "kaifuu softpal extract: units={} warnings={}",
        extraction.bridge.units.len(),
        extraction.warnings.len(),
    );
    Ok(())
}

fn run_patch_softpal_bundle(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let source = PathBuf::from(flag(args, "--source")?);
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
