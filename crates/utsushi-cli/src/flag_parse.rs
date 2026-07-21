//! Generic CLI flag parsing helpers shared across `utsushi` subcommands.
//!
//! Each subcommand owns the matrix of value flags (`--output <path>`),
//! boolean flags (`--skip-browser`), and positional arguments it accepts.
//! These helpers centralize the strict-rejection parsing contract: unknown
//! flags, missing values, duplicate flags, and missing positionals each
//! fail with a typed error rather than silently dropping or defaulting.
//!
//! The `usage` parameter is the subcommand's USAGE line so error messages
//! point the operator at the correct surface.

/// Look up a required value flag. Returns a typed error if the flag is
/// absent.
pub(crate) fn flag<'a>(
    args: &'a [String],
    name: &str,
    usage: &str,
) -> Result<&'a str, Box<dyn std::error::Error>> {
    optional_flag(args, name).ok_or_else(|| format!("missing flag {name}; {usage}").into())
}

/// Look up an optional value flag. Returns `None` if absent.
pub(crate) fn optional_flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

/// Strict flag validation for a subcommand invocation. Walks `args` once
/// to reject unknown flags, duplicate flags, missing flag values, missing
/// positionals, and trailing positional arguments. `--output` (when
/// listed under `value_flags`) is treated as required.
pub(crate) fn validate_exact_flags(
    args: &[String],
    positional_labels: &[&str],
    value_flags: &[&str],
    boolean_flags: &[&str],
    usage: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let expected_positionals = 1 + positional_labels.len();
    if args.len() < expected_positionals {
        let missing = positional_labels[args.len().saturating_sub(1)];
        return Err(format!("missing {missing}; {usage}").into());
    }
    for index in 1..expected_positionals {
        if args[index].starts_with("--") {
            return Err(format!("missing {}; {usage}", positional_labels[index - 1]).into());
        }
    }

    let mut seen_flags = std::collections::HashSet::new();
    let mut index = expected_positionals;
    while index < args.len() {
        let flag = args[index].as_str();
        if !flag.starts_with("--") {
            return Err(format!("unexpected argument {flag}; {usage}").into());
        }
        if boolean_flags.contains(&flag) {
            if !seen_flags.insert(flag) {
                return Err(format!("duplicate flag {flag}; {usage}").into());
            }
            index += 1;
            continue;
        }
        if !value_flags.contains(&flag) {
            return Err(format!("unknown flag {flag}; {usage}").into());
        }
        if !seen_flags.insert(flag) {
            return Err(format!("duplicate flag {flag}; {usage}").into());
        }
        let Some(value) = args.get(index + 1) else {
            return Err(format!("missing value for flag {flag}; {usage}").into());
        };
        if value.starts_with("--") {
            return Err(format!("missing value for flag {flag}; {usage}").into());
        }
        index += 2;
    }

    for required_flag in value_flags.iter().filter(|flag| **flag == "--output") {
        if !seen_flags.contains(required_flag) {
            return Err(format!("missing flag {required_flag}; {usage}").into());
        }
    }
    Ok(())
}
