use std::path::PathBuf;

use crate::{atomic_write_text, flag, flag_optional, positional};

/// `kaifuu wolf readiness --fixture <cases.json> [--output <report.json>]`.
/// Produces the Wolf RPG Editor readiness proof: for each synthetic case it runs
/// the protection detector AND the key/protection helper
/// boundary over the embedded evidence and COMBINES their derived outputs into
/// one per-capability-level readiness report. It reports the ACHIEVED level
/// (identify / inventory / helper-required / extract / patch / unsupported)
/// mechanically per the fixture evidence and never claims a level beyond it:
/// extract/patch are claimed only where an explicit synthetic fixture proof
/// backs them and every lower key/helper gate is cleared. Writes the redacted
/// report to `--output` (or stdout) and exits non-zero, listing each failing
/// case's finding codes, when any case fails validation.
pub(crate) fn run_wolf_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "readiness" => run_wolf_readiness_command(args),
        other => Err(format!(
            "usage: kaifuu wolf <readiness> ...\n  readiness --fixture <cases.json> [--output <report.json>]\ngot {other:?}"
        )
        .into()),
    }
}

fn run_wolf_readiness_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let fixture_path = PathBuf::from(flag(args, "--fixture")?);
    let fixture = kaifuu_core::read_wolf_readiness_fixture(&fixture_path)?;
    let report = kaifuu_core::run_wolf_readiness(&fixture);
    let redacted = report.redacted_for_report();
    let json = redacted.stable_json()?;
    match flag_optional(args, "--output") {
        Some(output) => atomic_write_text(&PathBuf::from(output), &json)?,
        None => println!("{json}"),
    }
    // Surface the per-case achieved level to stderr so CI logs carry the level
    // ladder without re-reading the report.
    for entry in &redacted.entries {
        eprintln!(
            "kaifuu wolf readiness: case={} level={} status={:?}",
            entry.case_id,
            entry.readiness_level.as_str(),
            entry.status
        );
    }
    if redacted.status == kaifuu_core::OperationStatus::Failed {
        let failures = redacted
            .entries
            .iter()
            .filter(|entry| entry.status == kaifuu_core::OperationStatus::Failed)
            .map(|entry| {
                let codes = entry
                    .findings
                    .iter()
                    .map(|finding| finding.code.clone())
                    .collect::<Vec<_>>()
                    .join(",");
                format!("{} [{}]", entry.case_id, codes)
            })
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("Wolf readiness validation failed: {failures}").into());
    }
    Ok(())
}
