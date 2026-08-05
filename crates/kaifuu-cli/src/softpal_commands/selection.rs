//! Softpal mapping from the shared extraction scope to `TEXT.DAT` records.
//!
//! A unit-set names the emitted stable bridge key, whose pointer is an exact
//! `TEXT.DAT` record boundary. A unit-range orders those units by that record
//! offset (with the surface kind only breaking a same-record tie). Both
//! coordinates are facts of the source files rather than decoder policy.

use std::collections::BTreeSet;
use std::error::Error;

use crate::extract_scope::ExtractScope;

pub(super) fn select_unit_indices(
    scope: &ExtractScope,
    source_unit_keys: &[String],
) -> Result<Vec<usize>, Box<dyn Error>> {
    let ordered = ordered_unit_indices(source_unit_keys)?;
    match scope {
        ExtractScope::All => Ok(ordered),
        ExtractScope::UnitSet { unit_ids } => select_unit_set(unit_ids, source_unit_keys, &ordered),
        ExtractScope::UnitRange {
            start,
            end_exclusive,
        } => select_unit_range(*start, *end_exclusive, &ordered),
    }
}

fn select_unit_set(
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
            "kaifuu.extract.scope.unknown_unit_id: engine softpal has no TEXT.DAT record key {unit_id:?}"
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
    start: usize,
    end_exclusive: usize,
    ordered: &[usize],
) -> Result<Vec<usize>, Box<dyn Error>> {
    ordered.get(start..end_exclusive).map_or_else(
        || {
            Err(format!(
                "kaifuu.extract.scope.range_out_of_bounds: engine softpal has {} TEXT.DAT text records; requested [{start}, {end_exclusive})",
                ordered.len()
            )
            .into())
        },
        |selected| Ok(selected.to_vec()),
    )
}

fn ordered_unit_indices(source_unit_keys: &[String]) -> Result<Vec<usize>, Box<dyn Error>> {
    let mut coordinates = source_unit_keys
        .iter()
        .enumerate()
        .map(|(index, source_unit_key)| {
            source_unit_coordinate(source_unit_key)
                .map(|(record_offset, surface)| (record_offset, surface, index))
        })
        .collect::<Result<Vec<_>, _>>()?;
    coordinates.sort_unstable();
    Ok(coordinates.into_iter().map(|(_, _, index)| index).collect())
}

fn source_unit_coordinate(source_unit_key: &str) -> Result<(u32, u8), Box<dyn Error>> {
    let (surface, record_offset) = if let Some(value) =
        source_unit_key.strip_prefix("softpal:dialogue:")
    {
        (0, value)
    } else if let Some(value) = source_unit_key.strip_prefix("softpal:choice:") {
        (1, value)
    } else {
        return Err(format!(
            "kaifuu.extract.scope.invalid_source_unit_key: engine softpal emitted {source_unit_key:?}, expected a softpal dialogue or choice TEXT.DAT record key"
        )
        .into());
    };
    let record_offset = record_offset.parse::<u32>().map_err(|_| {
        format!(
            "kaifuu.extract.scope.invalid_source_unit_key: engine softpal emitted {source_unit_key:?}, whose TEXT.DAT record offset is not a u32"
        )
    })?;
    Ok((record_offset, surface))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> Vec<String> {
        [
            "softpal:choice:40",
            "softpal:dialogue:16",
            "softpal:choice:16",
            "softpal:dialogue:31",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    }

    #[test]
    fn all_and_range_follow_textdat_record_order() {
        let source_keys = keys();
        assert_eq!(
            select_unit_indices(&ExtractScope::All, &source_keys).expect("all scope selects"),
            vec![1, 2, 3, 0]
        );
        assert_eq!(
            select_unit_indices(
                &ExtractScope::UnitRange {
                    start: 1,
                    end_exclusive: 3,
                },
                &source_keys,
            )
            .expect("range scope selects"),
            vec![2, 3]
        );
    }

    #[test]
    fn unit_set_uses_complete_format_record_keys() {
        let source_keys = keys();
        assert_eq!(
            select_unit_indices(
                &ExtractScope::UnitSet {
                    unit_ids: vec![
                        "softpal:choice:40".to_owned(),
                        "softpal:dialogue:16".to_owned(),
                    ],
                },
                &source_keys,
            )
            .expect("record keys select"),
            vec![1, 0]
        );
    }

    #[test]
    fn selection_rejects_unknown_keys_and_out_of_bounds_ranges() {
        let source_keys = keys();
        let unknown = select_unit_indices(
            &ExtractScope::UnitSet {
                unit_ids: vec!["softpal:dialogue:99".to_owned()],
            },
            &source_keys,
        )
        .expect_err("unknown record key fails");
        assert!(unknown.to_string().contains("unknown_unit_id"));

        let range = select_unit_indices(
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
