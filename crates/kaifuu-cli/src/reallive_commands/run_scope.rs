use std::collections::BTreeSet;

use kaifuu_reallive::ArchiveScope;

use crate::{flag, flag_present};

pub(super) enum RequestedScope {
    WholeArchive,
    Scenes(BTreeSet<u16>),
    UnitRange { start: usize, end_exclusive: usize },
}

impl RequestedScope {
    pub(super) fn bridge_scope(&self) -> ArchiveScope {
        match self {
            Self::WholeArchive => ArchiveScope::WholeArchive,
            Self::Scenes(_) => ArchiveScope::SceneSet,
            Self::UnitRange {
                start,
                end_exclusive,
            } => ArchiveScope::UnitRange {
                start: *start,
                end_exclusive: *end_exclusive,
            },
        }
    }

    pub(super) fn includes_scene(&self, scene_id: u16) -> bool {
        match self {
            Self::WholeArchive | Self::UnitRange { .. } => true,
            Self::Scenes(scene_ids) => scene_ids.contains(&scene_id),
        }
    }

    pub(super) fn report_scope(&self) -> &'static str {
        match self {
            Self::WholeArchive => "whole-seen",
            Self::Scenes(_) => "scene-set",
            Self::UnitRange { .. } => "unit-range",
        }
    }
}

pub(super) fn parse_requested_scope(
    args: &[String],
) -> Result<RequestedScope, Box<dyn std::error::Error>> {
    let whole = flag_present(args, "--whole-seen");
    let scene = flag_present(args, "--scene");
    let scenes = flag_present(args, "--scenes");
    let range = flag_present(args, "--unit-range");
    let selected = [whole, scene, scenes, range]
        .iter()
        .filter(|selected| **selected)
        .count();
    if selected != 1 {
        return Err("choose exactly one scope: --whole-seen, --scene <N>, --scenes <N,N,...>, or --unit-range <START:END>".into());
    }
    if whole {
        return Ok(RequestedScope::WholeArchive);
    }
    if scene {
        return Ok(RequestedScope::Scenes(
            [flag(args, "--scene")?.parse()?].into(),
        ));
    }
    if scenes {
        let ids = flag(args, "--scenes")?
            .split(',')
            .map(|raw| {
                raw.parse::<u16>()
                    .map_err(|_| format!("--scenes contains invalid u16 scene id {raw:?}"))
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        if ids.is_empty() {
            return Err("--scenes must contain at least one scene id".into());
        }
        return Ok(RequestedScope::Scenes(ids));
    }
    let raw = flag(args, "--unit-range")?;
    let (start, end_exclusive) = raw
        .split_once(':')
        .ok_or("--unit-range must be START:END (end is exclusive)")?;
    Ok(RequestedScope::UnitRange {
        start: start.parse()?,
        end_exclusive: end_exclusive.parse()?,
    })
}
