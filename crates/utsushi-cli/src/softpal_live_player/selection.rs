use std::error::Error;

use kaifuu_softpal::{ScriptScan, TextDat};
use utsushi_softpal::point_entry_offsets;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PointSelection {
    Exact(u32),
    Auto,
}

pub(super) fn parse_point_selection(value: &str) -> Result<PointSelection, Box<dyn Error>> {
    if value == "auto" {
        return Ok(PointSelection::Auto);
    }
    Ok(PointSelection::Exact(value.parse()?))
}

/// Rank point-table ids by the distance to the first resolved dialogue command
/// at or after their byte-designated script offset.
pub(super) fn dialogue_point_candidates(
    script: &[u8],
    textdat: &[u8],
    points: &[u8],
) -> Result<Vec<u32>, Box<dyn Error>> {
    let disassembly = ScriptScan::parse(script)?.resolve(&TextDat::parse(textdat)?);
    if !disassembly.is_fully_resolved() {
        return Err(
            "softpal-live-player --point auto requires a fully resolved static dialogue table"
                .into(),
        );
    }
    let dialogue_offsets = disassembly
        .dialogue
        .iter()
        .map(|dialogue| dialogue.command_offset)
        .collect::<Vec<_>>();
    let point_offsets = point_entry_offsets(points)?;
    Ok(rank_point_candidates(&point_offsets, &dialogue_offsets))
}

fn rank_point_candidates(point_offsets: &[usize], dialogue_offsets: &[usize]) -> Vec<u32> {
    let mut candidates = point_offsets
        .iter()
        .enumerate()
        .filter_map(|(index, point_offset)| {
            dialogue_offsets
                .iter()
                .find(|dialogue_offset| **dialogue_offset >= *point_offset)
                .and_then(|dialogue_offset| {
                    u32::try_from(index + 1)
                        .ok()
                        .map(|point_id| (dialogue_offset - point_offset, point_id))
                })
        })
        .collect::<Vec<_>>();
    candidates.sort_unstable();
    candidates
        .into_iter()
        .map(|(_, point_id)| point_id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::rank_point_candidates;

    #[test]
    fn ranks_the_nearest_byte_designated_dialogue_entry_first() {
        // Mutation proof: if automatic selection stops using the real
        // point-table-to-dialogue offset distance, it cannot choose entry 2.
        assert_eq!(
            rank_point_candidates(&[12, 60, 80], &[64, 120]),
            vec![2, 3, 1]
        );
    }
}
