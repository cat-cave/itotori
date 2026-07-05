//! UTSUSHI-070 — `coverage-export` subcommand.
//!
//! Reads a committed branch-coverage read-model fixture (the UTSUSHI-009
//! observations + route-map join inputs), builds the read model, and writes a
//! STABLE export artifact for alpha reports + offline review:
//!
//! - `--output <PATH>` — the JSON export (read model + gap summary, and gap
//!   findings when `--include-gap-findings` is set).
//! - `--markdown-output <PATH>` — an optional human-readable Markdown summary
//!   (coverage counts per status + gap counts / severity).
//!
//! The generated-at metadata is taken as an INJECTED `--generated-at` value,
//! never read from the clock, so the JSON + Markdown outputs are deterministic
//! and snapshot-testable. This command launches no runtime host, opens no
//! browser, and reads no screenshot artifact — it only reshapes committed data.

use std::path::PathBuf;

use utsushi_core::conformance::branch_coverage::read_model_from_json;
use utsushi_core::conformance::branch_coverage_export::{
    build_branch_coverage_export, render_branch_coverage_markdown,
};
use utsushi_core::write_json;

const USAGE: &str = "usage: utsushi coverage-export --read-model <PATH> --generated-at <RFC3339> --output <PATH> [--markdown-output <PATH>] [--include-gap-findings]";

const VALUE_FLAGS: &[&str] = &[
    "--read-model",
    "--generated-at",
    "--output",
    "--markdown-output",
];
const BOOL_FLAGS: &[&str] = &["--include-gap-findings"];

/// Run the `coverage-export` command. `tail` is argv with the leading
/// `coverage-export` slot already removed.
pub fn run_coverage_export_command(tail: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    // Strict flag validation: reject unknown flags, duplicate flags, and
    // missing values rather than silently ignoring them.
    let mut seen = std::collections::HashSet::new();
    let mut index = 0;
    while index < tail.len() {
        let arg = tail[index].as_str();
        if BOOL_FLAGS.contains(&arg) {
            if !seen.insert(arg) {
                return Err(format!("duplicate flag {arg}; {USAGE}").into());
            }
            index += 1;
            continue;
        }
        if VALUE_FLAGS.contains(&arg) {
            if !seen.insert(arg) {
                return Err(format!("duplicate flag {arg}; {USAGE}").into());
            }
            let value = tail.get(index + 1);
            if value.is_none_or(|value| value.starts_with("--")) {
                return Err(format!("missing value for flag {arg}; {USAGE}").into());
            }
            index += 2;
            continue;
        }
        return Err(format!("unexpected argument {arg}; {USAGE}").into());
    }

    let read_model_path = PathBuf::from(flag(tail, "--read-model")?);
    let generated_at = flag(tail, "--generated-at")?.to_string();
    let output = PathBuf::from(flag(tail, "--output")?);
    let markdown_output = optional_flag(tail, "--markdown-output").map(PathBuf::from);
    let include_findings = tail.iter().any(|arg| arg == "--include-gap-findings");

    let text = std::fs::read_to_string(&read_model_path)
        .map_err(|e| format!("read {}: {e}", read_model_path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("parse {}: {e}", read_model_path.display()))?;
    let read_model = read_model_from_json(value)?;

    let export = build_branch_coverage_export(&read_model, generated_at, include_findings)?;

    let json = serde_json::to_value(&export)?;
    write_json(&output, &json)?;

    if let Some(markdown_output) = markdown_output {
        let markdown = render_branch_coverage_markdown(&export);
        if let Some(parent) = markdown_output.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        std::fs::write(&markdown_output, markdown)
            .map_err(|e| format!("write {}: {e}", markdown_output.display()))?;
    }

    Ok(())
}

fn flag<'a>(tail: &'a [String], name: &str) -> Result<&'a str, Box<dyn std::error::Error>> {
    optional_flag(tail, name).ok_or_else(|| format!("missing flag {name}; {USAGE}").into())
}

fn optional_flag<'a>(tail: &'a [String], name: &str) -> Option<&'a str> {
    tail.iter()
        .position(|arg| arg == name)
        .and_then(|index| tail.get(index + 1))
        .map(String::as_str)
}
