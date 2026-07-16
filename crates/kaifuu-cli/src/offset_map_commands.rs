use std::path::PathBuf;

use crate::{flag, positional, read_json, validate_offset_map_value, write_json};

pub(crate) fn run_offset_map_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "validate" => {
            let offset_map_path = PathBuf::from(positional(args, 2)?);
            let output = PathBuf::from(flag(args, "--output")?);
            let value: serde_json::Value = read_json(&offset_map_path)?;
            let validation = validate_offset_map_value(&value);
            let failed = validation.status == kaifuu_core::OperationStatus::Failed;
            write_json(&output, &validation)?;
            if failed {
                return Err(format!(
                    "offset map validation failed: {}",
                    validation
                        .diagnostics
                        .iter()
                        .map(|diagnostic| diagnostic.code.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
                .into());
            }
        }
        _ => {
            return Err(
                "usage: kaifuu offset-map validate <offset-map.json> --output <report.json>".into(),
            );
        }
    }
    Ok(())
}
