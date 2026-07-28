//! Read-only VM proof on the two local corpora. No retail bytes are committed.

use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_softpal::{PacArchive, ScriptScan, TextDat};
use utsushi_softpal::{SceneStep, SoftpalScene};

const CORPORA: [&str; 2] = ["/scratch/corpus/softpal-1", "/scratch/corpus/softpal-2"];

fn inputs(root: &Path) -> Option<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let archive_bytes = fs::read(root.join("data.pac")).ok()?;
    let archive = PacArchive::parse(&archive_bytes).ok()?;
    let extract = |name| {
        archive
            .find(name)
            .and_then(|entry| archive.extract(&archive_bytes, entry).ok())
            .map(ToOwned::to_owned)
    };
    Some((
        extract("SCRIPT.SRC")?,
        extract("TEXT.DAT")?,
        extract("POINT.DAT")?,
    ))
}

fn dialogue_offsets(scene: &SoftpalScene) -> Vec<usize> {
    scene
        .steps
        .iter()
        .filter_map(|step| match step {
            SceneStep::Dialogue { command_offset, .. } => Some(*command_offset),
            _ => None,
        })
        .collect()
}

#[test]
fn executes_two_proven_native_state_transitions_before_the_next_visible_gap() {
    for (index, root) in CORPORA.iter().enumerate() {
        let root = PathBuf::from(root);
        let Some((script, textdat, points)) = inputs(&root) else {
            eprintln!(
                "SKIP corpus {}: missing data.pac or VM inputs at {}",
                index + 1,
                root.display()
            );
            continue;
        };
        let first = SoftpalScene::execute_with_points(&script, &textdat, Some(&points))
            .expect("VM input decodes");
        let second = SoftpalScene::execute_with_points(&script, &textdat, Some(&points))
            .expect("repeat VM input decodes");
        assert_eq!(
            first,
            second,
            "corpus {} deterministic moment sequence",
            index + 1
        );
        assert!(
            first.stats.opcode_exhaustive,
            "corpus {} exhaustive opcode catalog",
            index + 1
        );
        let linear = ScriptScan::parse(&script)
            .expect("linear scan")
            .resolve(&TextDat::parse(&textdat).expect("text pool"));
        let expected: Vec<_> = linear
            .dialogue
            .iter()
            .map(|line| line.command_offset)
            .collect();
        let observed = dialogue_offsets(&first);
        let overlap = observed
            .iter()
            .zip(&expected)
            .take_while(|(observed, expected)| observed == expected)
            .count();
        assert!(
            overlap == observed.len(),
            "corpus {} emitted dialogue remains an ordered oracle prefix",
            index + 1
        );
        assert_eq!(observed.len(), 0, "executed setup must not invent text");
        let diagnostics = first.diagnostic_frequencies();
        eprintln!(
            "[corpus {}] first diagnostic={:?} instructions={}",
            index + 1,
            first.diagnostics.first(),
            first.stats.instructions_executed
        );
        assert_eq!(
            first.stats.unresolved_construct_count,
            first.diagnostics.len()
        );
        assert_eq!(
            first.diagnostics.len(),
            1,
            "corpus {} stops at one named visible gap",
            index + 1
        );
        assert_eq!(
            first.diagnostics[0].signature,
            "operand_tag_01",
            "corpus {} names its next visible gap",
            index + 1
        );
        assert_eq!(
            first.diagnostics[0].offset,
            [200, 280][index],
            "corpus {} next visible gap offset",
            index + 1
        );
        assert_eq!(
            first.stats.instructions_executed,
            [143, 159][index],
            "corpus {} advances to the operand-memory boundary",
            index + 1
        );
        assert!(
            first.stats.work_process_attached,
            "corpus {} records the modeled work-process attachment",
            index + 1
        );
        eprintln!(
            "[corpus {}] moments={} text={} speaker=0 choice={} branch={} instructions={} overlap={}/{} unresolved={:?}",
            index + 1,
            first.steps.len(),
            first.stats.dialogue_count,
            first.stats.text_bearing_choice_count,
            first.stats.branch_count,
            first.stats.instructions_executed,
            overlap,
            observed.len(),
            diagnostics,
        );
    }
}
