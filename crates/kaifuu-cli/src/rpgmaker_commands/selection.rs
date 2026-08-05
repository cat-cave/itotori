//! RPG Maker MV/MZ mapping from shared scopes to source JSON surfaces.
//!
//! A unit-set uses the stable `rpgmaker:<file>#<json-pointer>` key emitted by
//! the bridge. A unit-range orders the file name lexicographically, then walks
//! its RFC 6901 JSON-pointer components: array indexes numerically and object
//! member names lexicographically. Both coordinates are source-format facts,
//! not traversal or decoder implementation details.

use std::collections::BTreeSet;
use std::error::Error;

use kaifuu_core::BridgeBundleV02;
use serde_json::Value;

use crate::extract_scope::ExtractScope;

/// Return a v0.2-valid copy whose units match a shared extraction scope.
///
/// The full bundle's asset manifest and source revision deliberately remain
/// intact: they describe the source snapshot from which the selected units
/// came. A second v0.2 validation makes this boundary safe if the bridge wire
/// contract changes.
pub(super) fn filter_bundle_for_scope(
    bundle: &Value,
    engine: &str,
    scope: &ExtractScope,
) -> Result<Value, Box<dyn Error>> {
    BridgeBundleV02::validate_json(bundle).map_err(|error| {
        format!("kaifuu.extract.scope.invalid_bundle: engine {engine} produced an invalid v0.2 bundle: {error}")
    })?;
    let units = bundle.get("units").and_then(Value::as_array).ok_or_else(|| {
        format!(
            "kaifuu.extract.scope.invalid_bundle: engine {engine} v0.2 bundle is missing its units array"
        )
    })?;
    let source_unit_keys = units
        .iter()
        .enumerate()
        .map(|(index, unit)| source_unit_key(unit, index, engine))
        .collect::<Result<Vec<_>, _>>()?;
    let selected = select_unit_indices(engine, scope, &source_unit_keys)?;
    let selected_units = selected
        .into_iter()
        .map(|index| units[index].clone())
        .collect::<Vec<_>>();
    let mut filtered = bundle.clone();
    filtered["units"] = Value::Array(selected_units);
    BridgeBundleV02::validate_json(&filtered).map_err(|error| {
        format!("kaifuu.extract.scope.invalid_filtered_bundle: engine {engine} produced an invalid scoped v0.2 bundle: {error}")
    })?;
    Ok(filtered)
}

pub(super) fn unit_count(bundle: &Value) -> Result<usize, Box<dyn Error>> {
    bundle
        .get("units")
        .and_then(Value::as_array)
        .map(Vec::len)
        .ok_or_else(|| {
            "kaifuu.extract.scope.invalid_filtered_bundle: units must be an array".into()
        })
}

fn select_unit_indices(
    engine: &str,
    scope: &ExtractScope,
    source_unit_keys: &[String],
) -> Result<Vec<usize>, Box<dyn Error>> {
    let ordered = ordered_unit_indices(engine, source_unit_keys)?;
    match scope {
        ExtractScope::All => Ok(ordered),
        ExtractScope::UnitSet { unit_ids } => {
            select_unit_set(engine, unit_ids, source_unit_keys, &ordered)
        }
        ExtractScope::UnitRange {
            start,
            end_exclusive,
        } => select_unit_range(engine, *start, *end_exclusive, &ordered),
    }
}

fn select_unit_set(
    engine: &str,
    unit_ids: &[String],
    source_unit_keys: &[String],
    ordered: &[usize],
) -> Result<Vec<usize>, Box<dyn Error>> {
    let requested = unit_ids.iter().map(String::as_str).collect::<BTreeSet<_>>();
    let available = source_unit_keys
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if let Some(unit_id) = requested.difference(&available).next() {
        return Err(format!(
            "kaifuu.extract.scope.unknown_unit_id: engine {engine} has no RPG Maker source key {unit_id:?}"
        )
        .into());
    }
    Ok(ordered
        .iter()
        .copied()
        .filter(|index| requested.contains(source_unit_keys[*index].as_str()))
        .collect())
}

fn select_unit_range(
    engine: &str,
    start: usize,
    end_exclusive: usize,
    ordered: &[usize],
) -> Result<Vec<usize>, Box<dyn Error>> {
    ordered.get(start..end_exclusive).map_or_else(
        || {
            Err(format!(
                "kaifuu.extract.scope.range_out_of_bounds: engine {engine} has {} RPG Maker source units; requested [{start}, {end_exclusive})",
                ordered.len()
            )
            .into())
        },
        |selected| Ok(selected.to_vec()),
    )
}

fn ordered_unit_indices(
    engine: &str,
    source_unit_keys: &[String],
) -> Result<Vec<usize>, Box<dyn Error>> {
    let mut seen = BTreeSet::new();
    let mut coordinates = source_unit_keys
        .iter()
        .enumerate()
        .map(|(index, source_unit_key)| {
            let (file, pointer) = source_unit_coordinate(engine, source_unit_key)?;
            let pointer = json_pointer_tokens(engine, source_unit_key, pointer)?;
            if !seen.insert(source_unit_key.as_str()) {
                return Err(format!(
                    "kaifuu.extract.scope.duplicate_source_unit_key: engine {engine} emitted duplicate RPG Maker source key {source_unit_key:?}"
                )
                .into());
            }
            Ok((file.to_owned(), pointer, index))
        })
        .collect::<Result<Vec<_>, Box<dyn Error>>>()?;
    coordinates.sort_unstable();
    Ok(coordinates.into_iter().map(|(_, _, index)| index).collect())
}

fn source_unit_key(unit: &Value, index: usize, engine: &str) -> Result<String, Box<dyn Error>> {
    unit.get("sourceUnitKey")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            format!(
                "kaifuu.extract.scope.invalid_bundle: engine {engine} units[{index}].sourceUnitKey must be a string"
            )
            .into()
        })
}

fn source_unit_coordinate<'a>(
    engine: &str,
    source_unit_key: &'a str,
) -> Result<(&'a str, &'a str), Box<dyn Error>> {
    let value = source_unit_key.strip_prefix("rpgmaker:").ok_or_else(|| {
        format!(
            "kaifuu.extract.scope.invalid_source_unit_key: engine {engine} emitted {source_unit_key:?}, expected rpgmaker:<file>#<json-pointer>"
        )
    })?;
    let (file, pointer) = value.split_once('#').ok_or_else(|| {
        format!(
            "kaifuu.extract.scope.invalid_source_unit_key: engine {engine} emitted {source_unit_key:?}, expected rpgmaker:<file>#<json-pointer>"
        )
    })?;
    if file.is_empty() || !pointer.starts_with('/') {
        return Err(format!(
            "kaifuu.extract.scope.invalid_source_unit_key: engine {engine} emitted {source_unit_key:?}, expected rpgmaker:<file>#<json-pointer>"
        )
        .into());
    }
    Ok((file, pointer))
}

#[derive(Debug, Eq, Ord, PartialEq, PartialOrd)]
enum JsonPointerToken {
    ArrayIndex(usize),
    ObjectMember(String),
}

fn json_pointer_tokens(
    engine: &str,
    source_unit_key: &str,
    pointer: &str,
) -> Result<Vec<JsonPointerToken>, Box<dyn Error>> {
    pointer[1..]
        .split('/')
        .map(|raw| decode_json_pointer_token(engine, source_unit_key, raw))
        .map(|token| {
            token.map(|token| {
                token
                    .parse::<usize>()
                    .map(JsonPointerToken::ArrayIndex)
                    .unwrap_or(JsonPointerToken::ObjectMember(token))
            })
        })
        .collect()
}

fn decode_json_pointer_token(
    engine: &str,
    source_unit_key: &str,
    raw: &str,
) -> Result<String, Box<dyn Error>> {
    let mut decoded = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(character) = chars.next() {
        if character != '~' {
            decoded.push(character);
            continue;
        }
        match chars.next() {
            Some('0') => decoded.push('~'),
            Some('1') => decoded.push('/'),
            _ => {
                return Err(format!(
                    "kaifuu.extract.scope.invalid_source_unit_key: engine {engine} emitted {source_unit_key:?}, whose JSON pointer is not RFC 6901 encoded"
                )
                .into());
            }
        }
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> Vec<String> {
        [
            "rpgmaker:Map010.json#/events/10/pages/0/list/1/parameters/0",
            "rpgmaker:Actors.json#/1/name",
            "rpgmaker:Map010.json#/events/2/pages/0/list/10/parameters/0",
            "rpgmaker:Map010.json#/events/2/pages/0/list/2/parameters/0",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    }

    #[test]
    fn all_and_range_follow_file_then_json_pointer_order() {
        let source_keys = keys();
        assert_eq!(
            select_unit_indices("rpgmaker", &ExtractScope::All, &source_keys)
                .expect("all scope selects"),
            vec![1, 3, 2, 0]
        );
        assert_eq!(
            select_unit_indices(
                "rpgmaker",
                &ExtractScope::UnitRange {
                    start: 1,
                    end_exclusive: 3,
                },
                &source_keys,
            )
            .expect("range scope selects"),
            vec![3, 2]
        );
    }

    #[test]
    fn unit_set_uses_complete_stable_source_keys() {
        let source_keys = keys();
        assert_eq!(
            select_unit_indices(
                "rpg-maker",
                &ExtractScope::UnitSet {
                    unit_ids: vec![
                        "rpgmaker:Map010.json#/events/10/pages/0/list/1/parameters/0".to_owned(),
                        "rpgmaker:Actors.json#/1/name".to_owned(),
                    ],
                },
                &source_keys,
            )
            .expect("source keys select"),
            vec![1, 0]
        );
    }

    #[test]
    fn selection_rejects_unknown_keys_and_out_of_bounds_ranges() {
        let source_keys = keys();
        let unknown = select_unit_indices(
            "rpgmaker",
            &ExtractScope::UnitSet {
                unit_ids: vec!["rpgmaker:Map999.json#/events/1".to_owned()],
            },
            &source_keys,
        )
        .expect_err("unknown source key fails");
        assert!(unknown.to_string().contains("unknown_unit_id"));

        let range = select_unit_indices(
            "rpgmaker",
            &ExtractScope::UnitRange {
                start: 3,
                end_exclusive: 5,
            },
            &source_keys,
        )
        .expect_err("out-of-bounds range fails");
        assert!(range.to_string().contains("range_out_of_bounds"));
    }
}
