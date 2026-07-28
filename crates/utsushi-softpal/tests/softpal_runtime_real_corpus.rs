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
fn executes_pac_backed_file_setup_until_the_next_named_native_gap() {
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
        let terminal_offset = first.diagnostics[0].offset;
        let terminal = OpcodeScan::parse(&inputs.script)
            .expect("opcode scan")
            .instructions
            .into_iter()
            .find(|instruction| instruction.offset == terminal_offset)
            .expect("terminal instruction exists");
        eprintln!(
            "[corpus {}] first diagnostic={:?} terminal_opcode={:02x} terminal_operands={:08x?} moments={} text={} choice={} branch={} instructions={}",
            index + 1,
            first.diagnostics.first(),
            terminal.opcode.id(),
            terminal
                .operands()
                .iter()
                .map(|operand| operand.raw)
                .collect::<Vec<_>>(),
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
            "corpus {} stops at one named visible gap",
            index + 1
        );
        assert_eq!(
            first.diagnostics[0].signature,
            "unimplemented_call_000d_0015",
            "corpus {} keeps the next gap named and visible",
            index + 1
        );
        assert_eq!(
            first.diagnostics[0].offset,
            [460, 540][index],
            "corpus {} has the measured native-gap offset",
            index + 1
        );
        assert_eq!(
            first.steps.len(),
            [134, 985][index],
            "corpus {} executed-moment count",
            index + 1
        );
        assert_eq!(
            first.stats.branch_count,
            [137, 1401][index],
            "corpus {} executed-branch count",
            index + 1
        );
        assert_eq!(
            first.stats.instructions_executed,
            [3567, 13906][index],
            "corpus {} advances through PAC-backed file setup",
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
