//! Argument parsing helpers for the `patch-render` command.

use std::error::Error;

pub(crate) fn parse_dimension(args: &[String], name: &str) -> Result<Option<u32>, Box<dyn Error>> {
    match optional_flag(args, name) {
        None => Ok(None),
        Some(value) => {
            let parsed = value.parse::<u32>().map_err(|err| {
                format!("utsushi.cli.patch_render.dimension_parse: {name} must be a u32: {err}")
            })?;
            if parsed == 0 {
                return Err(
                    format!("utsushi.cli.patch_render.dimension_zero: {name} must be > 0").into(),
                );
            }
            Ok(Some(parsed))
        }
    }
}

pub(crate) fn parse_message_index(args: &[String]) -> Result<Option<usize>, Box<dyn Error>> {
    optional_flag(args, "--message-index")
        .map(|value| {
            value.parse::<usize>().map_err(|err| {
                format!(
                    "utsushi.cli.patch_render.message_index_parse: --message-index must be a \
                     zero-based usize: {err}"
                )
                .into()
            })
        })
        .transpose()
}

pub(crate) fn required_flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn Error>> {
    optional_flag(args, name)
        .ok_or_else(|| format!("utsushi.cli.patch_render.missing_flag: {name}").into())
}

pub(crate) fn optional_flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}
