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
fn executes_deterministically_with_counted_halts_on_both_local_corpora() {
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
        assert!(
            observed.iter().all(|offset| expected.contains(offset)),
            "corpus {} execution is an ordered linear overlap",
            index + 1
        );
        let diagnostics = first.diagnostic_frequencies();
        assert_eq!(
            first.stats.unresolved_construct_count,
            first.diagnostics.len()
        );
        assert_eq!(
            diagnostics.get("native_task_operand_underflow"),
            Some(&1),
            "corpus {} stops loudly while the native task producers are unresolved",
            index + 1
        );
        assert_eq!(
            first.diagnostics.len(),
            1,
            "corpus {} records one deliberate stop, not a silent partial run",
            index + 1
        );
        eprintln!(
            "[corpus {}] moments={} text={} choice={} branch={} instructions={} unresolved={:?}",
            index + 1,
            first.steps.len(),
            first.stats.dialogue_count,
            first.stats.text_bearing_choice_count,
            first.stats.branch_count,
            first.stats.instructions_executed,
            diagnostics,
        );
    }
}
