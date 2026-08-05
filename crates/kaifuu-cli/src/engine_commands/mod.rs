//! Generic top-level dispatch for engine-owned command handlers.
//!
//! `main` delegates an engine-tagged command here once. The registry owns the
//! engine-to-handler mapping, while each adapter wrapper owns its verb-specific
//! implementation. A future engine therefore adds an adapter entry here rather
//! than a new branch to the process-wide command dispatcher.

mod adapters;

use std::error::Error;

use serde_json::{Map, Value};

pub(crate) type EngineCommandResult = Result<(), Box<dyn Error>>;

/// Generic, validated format configuration forwarded from the project layer.
///
/// The common dispatcher only establishes that this is one JSON object. An
/// engine adapter owns the interpretation of its declared keys. Existing
/// adapters declare no keys and therefore require an empty object.
#[derive(Debug, Default)]
pub(crate) struct EngineAdapterConfig {
    values: Map<String, Value>,
}

impl EngineAdapterConfig {
    #[must_use]
    pub(crate) fn values(&self) -> &Map<String, Value> {
        &self.values
    }

    /// Reject keys for an adapter whose declared schema is empty.
    pub(crate) fn require_empty(&self, engine: &str) -> EngineCommandResult {
        let keys = self
            .values()
            .keys()
            .map(|key| format!("adapter.{key}"))
            .collect::<Vec<_>>();
        if keys.is_empty() {
            return Ok(());
        }
        Err(format!(
            "kaifuu.engine_command.adapter_config.unknown_key: engine '{engine}' declares no adapter configuration; remove {}",
            keys.join(", "),
        )
        .into())
    }
}

/// The engine-neutral envelope delivered to an adapter-local handler.
pub(crate) struct EngineCommandInvocation<'a> {
    args: &'a [String],
    engine: &'a str,
    adapter_config: EngineAdapterConfig,
}

impl<'a> EngineCommandInvocation<'a> {
    #[must_use]
    pub(crate) fn args(&self) -> &'a [String] {
        self.args
    }

    #[must_use]
    pub(crate) fn engine(&self) -> &'a str {
        self.engine
    }

    #[must_use]
    pub(crate) fn adapter_config(&self) -> &EngineAdapterConfig {
        &self.adapter_config
    }

    #[must_use]
    pub(crate) fn verb(&self) -> &'a str {
        self.args.first().map(String::as_str).unwrap_or_default()
    }
}

/// Dispatch a recognized engine command and report whether this registry owned
/// it. Unrecognized engines retain the historical generic-command fallback.
pub(crate) fn dispatch(args: &[String]) -> Result<bool, Box<dyn Error>> {
    let Some(engine) = flag_value(args, "--engine") else {
        return Ok(false);
    };
    let Some(verb) = args.first().map(String::as_str) else {
        return Ok(false);
    };
    let Some(handler) = adapters::handler_for(engine, verb) else {
        return Ok(false);
    };

    let request = EngineCommandInvocation {
        args,
        engine,
        adapter_config: parse_adapter_config(args)?,
    };
    handler(request)?;
    Ok(true)
}

pub(super) type EngineCommandHandler =
    for<'a> fn(EngineCommandInvocation<'a>) -> EngineCommandResult;

fn parse_adapter_config(args: &[String]) -> Result<EngineAdapterConfig, Box<dyn Error>> {
    let locations = args
        .iter()
        .enumerate()
        .filter_map(|(index, argument)| (argument == "--adapter-config").then_some(index))
        .collect::<Vec<_>>();
    match locations.as_slice() {
        [] => Ok(EngineAdapterConfig::default()),
        [index] => {
            let raw = args.get(index + 1).ok_or(
                "kaifuu.engine_command.adapter_config.missing_value: --adapter-config requires a JSON object",
            )?;
            let value: Value = serde_json::from_str(raw).map_err(|error| {
                format!("kaifuu.engine_command.adapter_config.invalid_json: {error}")
            })?;
            let Some(values) = value.as_object() else {
                return Err(
                    "kaifuu.engine_command.adapter_config.invalid_shape: --adapter-config must be a JSON object"
                        .into(),
                );
            };
            Ok(EngineAdapterConfig {
                values: values.clone(),
            })
        }
        _ => Err(
            "kaifuu.engine_command.adapter_config.duplicate: --adapter-config may be supplied once"
                .into(),
        ),
    }
}

fn flag_value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn parses_one_generic_adapter_config_object() {
        let config = parse_adapter_config(&args(&[
            "extract",
            "--adapter-config",
            r#"{"formatRevision":3}"#,
        ]))
        .expect("an object config is valid");

        assert_eq!(config.values()["formatRevision"], 3);
    }

    #[test]
    fn rejects_non_object_or_duplicate_adapter_config() {
        let shape = parse_adapter_config(&args(&["extract", "--adapter-config", "[]"]))
            .expect_err("arrays are not adapter config objects");
        assert!(shape.to_string().contains("invalid_shape"));

        let duplicate = parse_adapter_config(&args(&[
            "extract",
            "--adapter-config",
            "{}",
            "--adapter-config",
            "{}",
        ]))
        .expect_err("one adapter config is allowed");
        assert!(duplicate.to_string().contains("duplicate"));

        let missing = parse_adapter_config(&args(&["extract", "--adapter-config"]))
            .expect_err("the config flag requires an object value");
        assert!(missing.to_string().contains("missing_value"));
    }

    #[test]
    fn registry_owns_known_engine_verb_pairs_only() {
        assert!(adapters::handler_for("reallive", "extract").is_some());
        assert!(adapters::handler_for("softpal", "verify").is_some());
        assert!(adapters::handler_for("siglus", "verify").is_none());
        assert!(adapters::handler_for("unknown", "extract").is_none());
    }

    #[test]
    fn validates_adapter_config_before_entering_the_selected_adapter() {
        let invalid = dispatch(&args(&[
            "extract",
            "--engine",
            "softpal",
            "--adapter-config",
            "[]",
        ]))
        .expect_err("recognized adapters reject non-object config before source parsing");
        assert!(invalid.to_string().contains("invalid_shape"));

        let unknown_key = dispatch(&args(&[
            "extract",
            "--engine",
            "softpal",
            "--scope",
            "all",
            "--bundle-output",
            "unused.json",
            "--adapter-config",
            r#"{"futureFormatSetting":"not-declared-by-current-adapter"}"#,
        ]))
        .expect_err("an empty-schema adapter rejects every config key");
        let message = unknown_key.to_string();
        assert!(message.contains("unknown_key"));
        assert!(message.contains("engine 'softpal'"));
        assert!(message.contains("adapter.futureFormatSetting"));
    }

    #[test]
    fn rpg_maker_alias_is_preserved_in_an_adapter_config_error() {
        let error = dispatch(&args(&[
            "extract",
            "--engine",
            "rpg-maker",
            "--adapter-config",
            r#"{"formatSetting":"not-declared"}"#,
        ]))
        .expect_err("the alias selects the RPG Maker adapter");
        let message = error.to_string();
        assert!(message.contains("engine 'rpg-maker'"));
        assert!(message.contains("adapter.formatSetting"));
    }
}
