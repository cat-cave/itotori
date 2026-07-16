use std::path::PathBuf;

use crate::{atomic_write_text, flag, flag_optional, positional};

/// `kaifuu bgi readiness --fixture <cases.json> [--output <report.json>]`.
/// Produces the BGI/Ethornell readiness proof: for each synthetic case it runs
/// the archive/container detector AND the scenario-bytecode
/// parser over the embedded evidence and COMBINES their derived outputs into one
/// per-capability-level readiness report. It reports the ACHIEVED level
/// (unsupported / identify / inventory / extract / patch) mechanically per the
/// fixture evidence and never claims a level beyond it: encrypted/compressed/
/// layered/unknown containers are unsupported, and extract/patch are claimed only
/// where an explicit synthetic fixture proof backs them and the outer container
/// gate is open. Writes the redacted report to `--output` (or stdout) and exits
/// non-zero, listing each failing case's finding codes, when any case fails.
pub(crate) fn run_bgi_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "readiness" => run_bgi_readiness_command(args),
        other => Err(format!(
            "usage: kaifuu bgi <readiness> ...\n  readiness --fixture <cases.json> [--output <report.json>]\ngot {other:?}"
        )
        .into()),
    }
}

fn run_bgi_readiness_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let fixture_path = PathBuf::from(flag(args, "--fixture")?);
    let fixture = kaifuu_core::read_bgi_readiness_fixture(&fixture_path)?;
    let report = kaifuu_core::run_bgi_readiness(&fixture);
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
            "kaifuu bgi readiness: case={} level={} status={:?}",
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
        return Err(format!("BGI readiness validation failed: {failures}").into());
    }
    Ok(())
}
