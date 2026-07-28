//! Read-only VM proof on the two local corpora. No retail bytes are committed.

use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_softpal::{OpcodeScan, PacArchive, ScriptScan, TextDat};
use utsushi_softpal::{SceneStep, SoftpalScene};

const CORPORA: [&str; 2] = ["/scratch/corpus/softpal-1", "/scratch/corpus/softpal-2"];

struct Inputs {
    archive: Vec<u8>,
    csv_pac: Vec<u8>,
    script: Vec<u8>,
    textdat: Vec<u8>,
    points: Vec<u8>,
    mem_dat: Vec<u8>,
}

fn inputs(root: &Path) -> Option<Inputs> {
    let archive_bytes = fs::read(root.join("data.pac")).ok()?;
    let archive = PacArchive::parse(&archive_bytes).ok()?;
    let extract = |name| {
        archive
            .find(name)
            .and_then(|entry| archive.extract(&archive_bytes, entry).ok())
            .map(ToOwned::to_owned)
    };
    let script = extract("SCRIPT.SRC")?;
    let textdat = extract("TEXT.DAT")?;
    let points = extract("POINT.DAT")?;
    let mem_dat = extract("MEM.DAT")?;
    let csv_pac = fs::read(root.join("csv.pac")).ok()?;
    Some(Inputs {
        archive: archive_bytes,
        csv_pac,
        script,
        textdat,
        points,
        mem_dat,
    })
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
fn reaches_the_named_work_process_boundary_without_fabricating_static_text() {
    for (index, root) in CORPORA.iter().enumerate() {
        let root = PathBuf::from(root);
        let Some(inputs) = inputs(&root) else {
            eprintln!(
                "SKIP corpus {}: missing data.pac or VM inputs at {}",
                index + 1,
                root.display()
            );
            continue;
        };
        let first = SoftpalScene::execute_with_points_mem_dat_and_pacs(
            &inputs.script,
            &inputs.textdat,
            Some(&inputs.points),
            Some(&inputs.mem_dat),
            &[&inputs.archive, &inputs.csv_pac],
        )
        .expect("VM input decodes");
        let second = SoftpalScene::execute_with_points_mem_dat_and_pacs(
            &inputs.script,
            &inputs.textdat,
            Some(&inputs.points),
            Some(&inputs.mem_dat),
            &[&inputs.archive, &inputs.csv_pac],
        )
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
        let linear = ScriptScan::parse(&inputs.script)
            .expect("linear scan")
            .resolve(&TextDat::parse(&inputs.textdat).expect("text pool"));
        let expected: Vec<_> = linear
            .dialogue
            .iter()
            .map(|line| line.command_offset)
            .collect();
        assert_eq!(
            expected.len(),
            [30_165, 39_832][index],
            "corpus {} static dialogue oracle remains available",
            index + 1
        );
        assert_eq!(
            linear.text_bearing_choice_count(),
            [11, 16][index],
            "corpus {} static choice oracle remains available",
            index + 1
        );
        let observed = dialogue_offsets(&first);
        let observed_speakers = first
            .dialogue_lines()
            .filter(|(speaker, _)| speaker.is_some())
            .count();
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
        let diagnostics = first.diagnostic_frequencies();
        let terminal = first.diagnostics.first().and_then(|diagnostic| {
            OpcodeScan::parse(&inputs.script)
                .expect("opcode scan")
                .instructions
                .into_iter()
                .find(|instruction| instruction.offset == diagnostic.offset)
        });
        eprintln!(
            "[corpus {}] first diagnostic={:?} terminal={:?} moments={} text={} choice={} branch={} instructions={}",
            index + 1,
            first.diagnostics.first(),
            terminal.map(|instruction| (
                instruction.opcode.id(),
                instruction
                    .operands()
                    .iter()
                    .map(|operand| operand.raw)
                    .collect::<Vec<_>>(),
            )),
            first.steps.len(),
            first.stats.dialogue_count,
            first.stats.text_bearing_choice_count,
            first.stats.branch_count,
            first.stats.instructions_executed
        );
        assert_eq!(
            first.stats.unresolved_construct_count,
            first.diagnostics.len()
        );
        assert_eq!(
            first.diagnostics.len(),
            1,
            "corpus {} must stop at the missing native callback boundary",
            index + 1
        );
        assert_eq!(
            first.diagnostics[0].signature,
            "work_process_callback_unavailable",
            "corpus {} exposes the unavailable callback rather than completing silently",
            index + 1
        );
        assert_eq!(
            first.diagnostics[0].offset,
            [576, 696][index],
            "corpus {} names the root-level return that needs its native callback",
            index + 1
        );
        assert_eq!(
            first.steps.len(),
            [134, 986][index],
            "corpus {} bootstrap moment count",
            index + 1
        );
        assert_eq!(
            first.stats.branch_count,
            [137, 1403][index],
            "corpus {} bootstrap branch count",
            index + 1
        );
        assert_eq!(
            first.stats.instructions_executed,
            [3578, 13919][index],
            "corpus {} bootstrap instruction count",
            index + 1
        );
        assert!(
            first.stats.work_process_attached,
            "corpus {} records the modeled work-process attachment",
            index + 1
        );
        eprintln!(
            "[corpus {}] moments={} text={} speaker={} choice={} branch={} instructions={} overlap={}/{} static_text={} unresolved={:?}",
            index + 1,
            first.steps.len(),
            first.stats.dialogue_count,
            observed_speakers,
            first.stats.text_bearing_choice_count,
            first.stats.branch_count,
            first.stats.instructions_executed,
            overlap,
            observed.len(),
            expected.len(),
            diagnostics,
        );
    }
}
