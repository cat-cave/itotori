//! Shared extraction-scope vocabulary for every engine-facing extract route.
//!
//! The caller describes *what portion* to extract without naming an archive,
//! scene format, or adapter implementation. Every declared adapter implements
//! every variant; adapters validate only their source-format coordinates.

use std::error::Error;

use crate::{flag, flag_present};

/// Engine-neutral extraction selection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ExtractScope {
    /// Extract every supported text-bearing unit in the source.
    All,
    /// Extract an explicit set of source-unit identifiers.
    UnitSet { unit_ids: Vec<String> },
    /// Extract a half-open range in deterministic source-unit order.
    UnitRange { start: usize, end_exclusive: usize },
}

/// Parse the engine-neutral extraction scope flags.
pub(crate) fn parse_extract_scope(args: &[String]) -> Result<ExtractScope, Box<dyn Error>> {
    reject_legacy_scope_flags(args)?;
    match flag(args, "--scope")? {
        "all" => {
            reject_scope_fields(args, &["--unit-ids", "--start", "--end-exclusive"])?;
            Ok(ExtractScope::All)
        }
        "unit-set" => {
            reject_scope_fields(args, &["--start", "--end-exclusive"])?;
            let unit_ids = parse_unit_ids(flag(args, "--unit-ids")? )?;
            Ok(ExtractScope::UnitSet { unit_ids })
        }
        "unit-range" => {
            reject_scope_fields(args, &["--unit-ids"])?;
            let start = parse_index(flag(args, "--start")?, "--start")?;
            let end_exclusive = parse_index(flag(args, "--end-exclusive")?, "--end-exclusive")?;
            if start >= end_exclusive {
                return Err(
                    "kaifuu.extract.scope.invalid_range: --start must be less than --end-exclusive"
                        .into(),
                );
            }
            Ok(ExtractScope::UnitRange {
                start,
                end_exclusive,
            })
        }
        value => Err(format!(
            "kaifuu.extract.scope.invalid_kind: --scope must be all, unit-set, or unit-range; got {value:?}"
        )
        .into()),
    }
}

fn reject_legacy_scope_flags(args: &[String]) -> Result<(), Box<dyn Error>> {
    for (legacy, replacement) in [
        ("--whole-seen", "--scope all"),
        ("--scene", "--scope unit-set --unit-ids <ID>"),
        ("--scenes", "--scope unit-set --unit-ids <ID,ID,...>"),
        (
            "--unit-range",
            "--scope unit-range --start <N> --end-exclusive <N>",
        ),
    ] {
        if flag_present(args, legacy) {
            return Err(format!(
                "kaifuu.extract.scope.legacy_flag: {legacy} is not supported; use {replacement}"
            )
            .into());
        }
    }
    Ok(())
}

fn reject_scope_fields(args: &[String], fields: &[&str]) -> Result<(), Box<dyn Error>> {
    if let Some(field) = fields.iter().find(|field| flag_present(args, field)) {
        return Err(format!(
            "kaifuu.extract.scope.unexpected_field: {field} is not valid with this --scope"
        )
        .into());
    }
    Ok(())
}

fn parse_unit_ids(raw: &str) -> Result<Vec<String>, Box<dyn Error>> {
    let unit_ids = raw
        .split(',')
        .map(str::trim)
        .map(str::to_string)
        .collect::<Vec<_>>();
    if unit_ids.is_empty() || unit_ids.iter().any(String::is_empty) {
        return Err(
            "kaifuu.extract.scope.invalid_unit_ids: --unit-ids must contain one or more non-empty identifiers"
                .into(),
        );
    }
    Ok(unit_ids)
}

fn parse_index(raw: &str, flag_name: &str) -> Result<usize, Box<dyn Error>> {
    raw.parse::<usize>().map_err(|_| {
        format!(
            "kaifuu.extract.scope.invalid_index: {flag_name} must be a non-negative integer; got {raw:?}"
        )
        .into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn parses_the_shared_all_scope() {
        assert_eq!(
            parse_extract_scope(&args(&["--scope", "all"])).unwrap(),
            ExtractScope::All
        );
    }

    #[test]
    fn parses_the_shared_unit_set_scope() {
        assert_eq!(
            parse_extract_scope(&args(&["--scope", "unit-set", "--unit-ids", "a, b"])).unwrap(),
            ExtractScope::UnitSet {
                unit_ids: vec!["a".to_string(), "b".to_string()],
            }
        );
    }

    #[test]
    fn parses_the_shared_unit_range_scope() {
        assert_eq!(
            parse_extract_scope(&args(&[
                "--scope",
                "unit-range",
                "--start",
                "3",
                "--end-exclusive",
                "8",
            ]))
            .unwrap(),
            ExtractScope::UnitRange {
                start: 3,
                end_exclusive: 8,
            }
        );
    }

    #[test]
    fn rejects_the_reallive_specific_scope_aliases() {
        let error = parse_extract_scope(&args(&["--whole-seen"])).expect_err("legacy flag fails");
        assert!(error.to_string().contains("--scope all"));
    }
}
