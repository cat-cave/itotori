use serde::Serialize;

#[derive(Debug, Clone, Copy)]
pub(super) struct CoverageInput {
    pub archive_scenes: usize,
    pub decoded_scenes: usize,
    pub loaded_scenes: usize,
    pub bridge_assets: usize,
    pub emitted_scenes: usize,
    pub archive_units: usize,
    pub emitted_units: usize,
    pub observed_units: usize,
    pub discovered_edges: usize,
    pub emitted_edges: usize,
    pub unresolved_edges: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Coverage {
    archive_scene_count: usize,
    decoded_scene_count: usize,
    loaded_scene_count: usize,
    bridge_asset_count: usize,
    emitted_scene_count: usize,
    archive_unit_count: usize,
    emitted_unit_count: usize,
    observed_unit_count: usize,
    archive_edge_count: usize,
    emitted_edge_count: usize,
    unresolved_edge_count: usize,
    truncation_status: &'static str,
    truncated: bool,
    complete: bool,
}

impl Coverage {
    pub fn validate(input: CoverageInput) -> Result<Self, String> {
        let scene_counts = [
            input.decoded_scenes,
            input.loaded_scenes,
            input.bridge_assets,
            input.emitted_scenes,
        ];
        if scene_counts
            .iter()
            .any(|count| *count != input.archive_scenes)
        {
            return Err(format!(
                "utsushi.structure.incomplete_scene_coverage: archive={} decoded={} loaded={} bridgeAssets={} emitted={}",
                input.archive_scenes,
                input.decoded_scenes,
                input.loaded_scenes,
                input.bridge_assets,
                input.emitted_scenes,
            ));
        }
        if input.emitted_units != input.archive_units {
            return Err(format!(
                "utsushi.structure.incomplete_unit_coverage: archive={} emitted={}",
                input.archive_units, input.emitted_units
            ));
        }
        if input.emitted_edges != input.discovered_edges {
            return Err(format!(
                "utsushi.structure.incomplete_edge_coverage: discovered={} emitted={}",
                input.discovered_edges, input.emitted_edges
            ));
        }
        Ok(Self {
            archive_scene_count: input.archive_scenes,
            decoded_scene_count: input.decoded_scenes,
            loaded_scene_count: input.loaded_scenes,
            bridge_asset_count: input.bridge_assets,
            emitted_scene_count: input.emitted_scenes,
            archive_unit_count: input.archive_units,
            emitted_unit_count: input.emitted_units,
            observed_unit_count: input.observed_units,
            archive_edge_count: input.discovered_edges,
            emitted_edge_count: input.emitted_edges,
            unresolved_edge_count: input.unresolved_edges,
            truncation_status: "complete",
            truncated: false,
            complete: true,
        })
    }
}

pub(super) fn reject_truncating_limit(
    max_scenes: usize,
    archive_scenes: usize,
) -> Result<(), String> {
    if max_scenes < archive_scenes {
        return Err(format!(
            "utsushi.structure.truncated: --max-scenes={max_scenes} cannot cover {archive_scenes} archive scenes; no artifact was written"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn complete() -> CoverageInput {
        CoverageInput {
            archive_scenes: 2,
            decoded_scenes: 2,
            loaded_scenes: 2,
            bridge_assets: 2,
            emitted_scenes: 2,
            archive_units: 4,
            emitted_units: 4,
            observed_units: 3,
            discovered_edges: 2,
            emitted_edges: 2,
            unresolved_edges: 1,
        }
    }

    #[test]
    fn truncated_scene_limit_is_a_hard_error() {
        let error = reject_truncating_limit(1, 2).expect_err("partial export must fail");
        assert!(error.contains("no artifact was written"));
    }

    #[test]
    fn missing_scene_unit_or_edge_is_a_hard_error() {
        for incomplete in [
            CoverageInput {
                emitted_scenes: 1,
                ..complete()
            },
            CoverageInput {
                emitted_units: 3,
                ..complete()
            },
            CoverageInput {
                emitted_edges: 1,
                ..complete()
            },
        ] {
            assert!(Coverage::validate(incomplete).is_err());
        }
    }

    #[test]
    fn explicit_unknown_edges_do_not_make_coverage_partial() {
        let coverage = Coverage::validate(complete()).expect("unknown edge is still emitted");
        assert_eq!(coverage.unresolved_edge_count, 1);
        assert!(coverage.complete);
    }
}
