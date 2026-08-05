//! Siglus mapping from the shared extraction scope to `Scene.pck` entries.
//!
//! The `Scene.pck` SceneList directory assigns every entry a stable `u32`
//! index within that archive revision. `unit-set` accepts those decimal
//! directory ids; `unit-range` walks that same directory order. The
//! identifiers and ordering therefore come from the file format, rather than a
//! decoder implementation detail.

use std::collections::BTreeSet;
use std::error::Error;

use kaifuu_siglus::SiglusSceneEntry;

use crate::extract_scope::ExtractScope;

pub(super) fn select_scene_entries<'a>(
    scope: &ExtractScope,
    entries: &'a [SiglusSceneEntry],
) -> Result<Vec<&'a SiglusSceneEntry>, Box<dyn Error>> {
    match scope {
        ExtractScope::All => Ok(entries.iter().collect()),
        ExtractScope::UnitSet { unit_ids } => select_scene_id_set(unit_ids, entries),
        ExtractScope::UnitRange {
            start,
            end_exclusive,
        } => select_scene_id_range(*start, *end_exclusive, entries),
    }
}

fn select_scene_id_set<'a>(
    unit_ids: &[String],
    entries: &'a [SiglusSceneEntry],
) -> Result<Vec<&'a SiglusSceneEntry>, Box<dyn Error>> {
    let requested = unit_ids
        .iter()
        .map(|unit_id| {
            unit_id.parse::<u32>().map_err(|_| {
                format!(
                    "kaifuu.extract.scope.invalid_unit_id: engine siglus requires each --unit-ids item to be a decimal Scene.pck SceneList id; got {unit_id:?}"
                )
            })
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    let available = entries
        .iter()
        .map(|entry| entry.scene_id)
        .collect::<BTreeSet<_>>();
    if let Some(scene_id) = requested.difference(&available).next() {
        return Err(format!(
            "kaifuu.extract.scope.unknown_unit_id: engine siglus has no Scene.pck SceneList id {scene_id}"
        )
        .into());
    }

    Ok(entries
        .iter()
        .filter(|entry| requested.contains(&entry.scene_id))
        .collect())
}

fn select_scene_id_range(
    start: usize,
    end_exclusive: usize,
    entries: &[SiglusSceneEntry],
) -> Result<Vec<&SiglusSceneEntry>, Box<dyn Error>> {
    entries.get(start..end_exclusive).map_or_else(
        || {
            Err(format!(
                "kaifuu.extract.scope.range_out_of_bounds: engine siglus has {} Scene.pck SceneList entries; requested [{start}, {end_exclusive})",
                entries.len()
            )
            .into())
        },
        |selected| Ok(selected.iter().collect()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries() -> Vec<SiglusSceneEntry> {
        vec![
            entry(7, "entry-seven"),
            entry(2, "entry-two"),
            entry(19, "entry-nineteen"),
        ]
    }

    fn entry(scene_id: u32, scene_name: &str) -> SiglusSceneEntry {
        SiglusSceneEntry {
            scene_id,
            scene_name: Some(scene_name.to_owned()),
            byte_offset: 0,
            byte_len: 0,
        }
    }

    fn selected_ids(scope: ExtractScope) -> Vec<u32> {
        let entries = entries();
        select_scene_entries(&scope, &entries)
            .expect("valid scope selects entries")
            .iter()
            .map(|entry| entry.scene_id)
            .collect()
    }

    #[test]
    fn unit_set_uses_decimal_scenelist_ids_and_preserves_directory_order() {
        assert_eq!(
            selected_ids(ExtractScope::UnitSet {
                unit_ids: vec!["19".to_owned(), "7".to_owned(), "19".to_owned()],
            }),
            vec![7, 19]
        );
    }

    #[test]
    fn unit_range_uses_half_open_scenelist_directory_positions() {
        assert_eq!(
            selected_ids(ExtractScope::UnitRange {
                start: 1,
                end_exclusive: 3,
            }),
            vec![2, 19]
        );
    }

    #[test]
    fn selection_reports_invalid_or_unknown_scenelist_ids() {
        let entries = entries();
        let invalid = select_scene_entries(
            &ExtractScope::UnitSet {
                unit_ids: vec!["not-a-number".to_owned()],
            },
            &entries,
        )
        .expect_err("SceneList ids are decimal u32 values");
        assert!(
            invalid
                .to_string()
                .contains("decimal Scene.pck SceneList id")
        );

        let unknown = select_scene_entries(
            &ExtractScope::UnitSet {
                unit_ids: vec!["8".to_owned()],
            },
            &entries,
        )
        .expect_err("unknown SceneList id is rejected");
        assert!(unknown.to_string().contains("unknown_unit_id"));
        assert!(unknown.to_string().contains("id 8"));
    }

    #[test]
    fn selection_reports_a_range_past_the_scenelist_directory() {
        let entries = entries();
        let error = select_scene_entries(
            &ExtractScope::UnitRange {
                start: 2,
                end_exclusive: 4,
            },
            &entries,
        )
        .expect_err("out-of-bounds range fails rather than silently clipping");

        assert!(error.to_string().contains("range_out_of_bounds"));
        assert!(error.to_string().contains("[2, 4)"));
    }
}
