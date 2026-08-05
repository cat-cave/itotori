use std::collections::BTreeSet;

use kaifuu_reallive::ArchiveScope;

use crate::extract_scope::{ExtractScope, parse_extract_scope};

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
            Self::WholeArchive => "all",
            Self::Scenes(_) => "unit-set",
            Self::UnitRange { .. } => "unit-range",
        }
    }
}

pub(super) fn parse_requested_scope(
    args: &[String],
) -> Result<RequestedScope, Box<dyn std::error::Error>> {
    match parse_extract_scope(args)? {
        ExtractScope::All => Ok(RequestedScope::WholeArchive),
        ExtractScope::UnitSet { unit_ids } => Ok(RequestedScope::Scenes(
            unit_ids
                .into_iter()
                .map(|unit_id| {
                    unit_id.parse::<u16>().map_err(|_| {
                        format!(
                            "kaifuu.extract.scope.invalid_unit_id: engine reallive requires each --unit-ids item to be a u16 scene id; got {unit_id:?}"
                        )
                    })
                })
                .collect::<Result<BTreeSet<_>, _>>()?,
        )),
        ExtractScope::UnitRange {
            start,
            end_exclusive,
        } => Ok(RequestedScope::UnitRange {
            start,
            end_exclusive,
        }),
    }
}
